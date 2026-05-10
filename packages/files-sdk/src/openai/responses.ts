import type { Files } from "../index.js";
import { resolveApproval } from "../internal/ai-tools/approval.js";
import type { ApprovalConfig } from "../internal/ai-tools/approval.js";
import { executors } from "../internal/ai-tools/executors.js";
import { toOpenAIJsonSchema } from "../internal/ai-tools/json-schema.js";
import {
  TOOL_SCHEMAS,
  WRITE_TOOL_NAMES,
} from "../internal/ai-tools/schemas.js";
import type {
  FileReadToolName,
  FileToolName,
  FileWriteToolName,
} from "../internal/ai-tools/schemas.js";
import type { ResponsesToolOverrides } from "./types.js";

/**
 * A function-tool definition shaped for OpenAI's Responses API. Pass an
 * array of these to `openai.responses.create({ tools })`.
 */
export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

/**
 * A function call emitted by the Responses API in `response.output[]`.
 */
export interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/**
 * A function-call output item to append to the next `responses.create`
 * input alongside the original `function_call` item.
 */
export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponsesFileTools {
  /**
   * Function tool definitions. Pass directly to
   * `openai.responses.create({ tools })`.
   */
  definitions: ResponsesFunctionTool[];
  /**
   * Execute a `function_call` item from the model's `response.output[]`.
   * Looks up the matching tool by name, parses and validates `arguments`,
   * runs the underlying `Files` operation, and returns a
   * `function_call_output` item ready to push into the next turn's input.
   *
   * `JSON.parse` failures and Zod validation errors are returned **as the
   * tool's output** so the model can self-correct on the next turn.
   * `FilesError` from the underlying SDK is rethrown — the caller decides
   * how to surface it.
   *
   * Approval is **not** enforced. Check {@link needsApproval} first if you
   * want a human-in-the-loop gate.
   */
  execute(call: FunctionCallItem): Promise<FunctionCallOutputItem>;
  /**
   * Returns whether the named tool is approval-gated under this config.
   * Read tools always return `false`. Unknown names return `false`.
   */
  needsApproval(name: string): boolean;
}

export interface ResponsesFileToolsOptions {
  /**
   * The configured `Files` instance the tools will operate against.
   */
  files: Files;
  /**
   * When `true`, write tools (`uploadFile`, `deleteFile`, `copyFile`,
   * `signUploadUrl`) are omitted from `definitions` and rejected by
   * `execute`. The model cannot mutate the bucket regardless of approval
   * configuration.
   */
  readOnly?: boolean;
  /**
   * Approval gating reflected by {@link ResponsesFileTools.needsApproval}.
   * Defaults to `true` (every write reports as approval-required). Pass
   * `false` to disable, or an object keyed by write-tool name for
   * fine-grained control. Unspecified entries in the object form default
   * to `true`.
   */
  requireApproval?: ApprovalConfig;
  /**
   * Per-tool overrides for the OpenAI tool definition (`description`,
   * `strict`). `name`, `parameters`, and `type` cannot be overridden.
   */
  overrides?: Partial<Record<FileToolName, ResponsesToolOverrides>>;
}

const TOOL_NAMES: readonly FileToolName[] = [
  "listFiles",
  "getFileMetadata",
  "downloadFile",
  "getFileUrl",
  "uploadFile",
  "deleteFile",
  "copyFile",
  "signUploadUrl",
];

const isWriteTool = (name: string): name is FileWriteToolName =>
  WRITE_TOOL_NAMES.has(name as FileWriteToolName);

type DispatchResult =
  | { ok: true; output: unknown }
  | { ok: false; issues: unknown };

const dispatch = async (
  files: Files,
  name: FileToolName,
  args: unknown
): Promise<DispatchResult> => {
  switch (name) {
    case "copyFile": {
      const v = TOOL_SCHEMAS.copyFile.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return { ok: true, output: await executors.copyFile(files, v.data) };
    }
    case "deleteFile": {
      const v = TOOL_SCHEMAS.deleteFile.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return { ok: true, output: await executors.deleteFile(files, v.data) };
    }
    case "downloadFile": {
      const v = TOOL_SCHEMAS.downloadFile.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return { ok: true, output: await executors.downloadFile(files, v.data) };
    }
    case "getFileMetadata": {
      const v = TOOL_SCHEMAS.getFileMetadata.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return {
        ok: true,
        output: await executors.getFileMetadata(files, v.data),
      };
    }
    case "getFileUrl": {
      const v = TOOL_SCHEMAS.getFileUrl.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return { ok: true, output: await executors.getFileUrl(files, v.data) };
    }
    case "listFiles": {
      const v = TOOL_SCHEMAS.listFiles.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return { ok: true, output: await executors.listFiles(files, v.data) };
    }
    case "signUploadUrl": {
      const v = TOOL_SCHEMAS.signUploadUrl.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return {
        ok: true,
        output: await executors.signUploadUrl(files, v.data),
      };
    }
    case "uploadFile": {
      const v = TOOL_SCHEMAS.uploadFile.input.safeParse(args);
      if (!v.success) {
        return { issues: v.error.issues, ok: false };
      }
      return { ok: true, output: await executors.uploadFile(files, v.data) };
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled tool: ${String(_exhaustive)}`);
    }
  }
};

/**
 * Create a set of files-sdk tools shaped for OpenAI's Responses API
 * (`openai.responses.create`).
 *
 * @example
 * ```ts
 * import OpenAI from "openai";
 * import { Files } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { createResponsesFileTools } from "files-sdk/openai";
 *
 * const client = new OpenAI();
 * const files = new Files({ adapter: s3({ bucket: "uploads" }) });
 * const ft = createResponsesFileTools({ files });
 *
 * const input: any[] = [{ role: "user", content: "List my files." }];
 * while (true) {
 *   const res = await client.responses.create({
 *     model: "gpt-4.1",
 *     input,
 *     tools: ft.definitions,
 *   });
 *   const calls = res.output.filter((o) => o.type === "function_call");
 *   if (calls.length === 0) break;
 *   for (const call of calls) {
 *     if (ft.needsApproval(call.name)) {
 *       // surface approval UX, then continue or break
 *     }
 *     input.push(call, await ft.execute(call));
 *   }
 * }
 * ```
 */
export const createResponsesFileTools = ({
  files,
  readOnly = false,
  requireApproval = true,
  overrides,
}: ResponsesFileToolsOptions): ResponsesFileTools => {
  const includedNames = TOOL_NAMES.filter(
    (name) => !(readOnly && isWriteTool(name))
  );

  const approvalFor = (name: string): boolean => {
    if (!isWriteTool(name)) {
      return false;
    }
    return resolveApproval(name, requireApproval);
  };

  const definitions: ResponsesFunctionTool[] = includedNames.map((name) => {
    const schema = TOOL_SCHEMAS[name];
    const override = overrides?.[name];
    return {
      description: override?.description ?? schema.description,
      name,
      parameters: toOpenAIJsonSchema(schema.input),
      strict: override?.strict ?? false,
      type: "function",
    };
  });

  const includedSet: ReadonlySet<FileToolName> = new Set(includedNames);

  const execute = async (
    call: FunctionCallItem
  ): Promise<FunctionCallOutputItem> => {
    const wrap = (output: unknown): FunctionCallOutputItem => ({
      call_id: call.call_id,
      output: typeof output === "string" ? output : JSON.stringify(output),
      type: "function_call_output",
    });

    if (!includedSet.has(call.name as FileToolName)) {
      return wrap({ error: `Unknown tool: ${call.name}` });
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch (error) {
      return wrap({
        error: `Invalid JSON in arguments: ${(error as Error).message}`,
      });
    }

    const result = await dispatch(files, call.name as FileToolName, parsedArgs);
    if (!result.ok) {
      return wrap({
        error: "Argument validation failed",
        issues: result.issues,
      });
    }
    return wrap(result.output);
  };

  return {
    definitions,
    execute,
    needsApproval: approvalFor,
  };
};

export type { FileReadToolName, FileToolName, FileWriteToolName };
