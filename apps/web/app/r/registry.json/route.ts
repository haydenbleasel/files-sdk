import { NextResponse } from "next/server";

import { getRegistry } from "@/lib/registry";

export const dynamic = "force-static";

// GET /r/registry.json — the registry index used by the shadcn CLI to discover
// the available files-sdk components.
export const GET = async () => NextResponse.json(await getRegistry());
