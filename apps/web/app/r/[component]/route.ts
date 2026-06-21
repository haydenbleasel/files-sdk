import { NextResponse } from "next/server";

import { getRegistryItem, getRegistryItems } from "@/lib/registry";

export const dynamic = "force-static";

interface RouteContext {
  params: Promise<{ component: string }>;
}

// GET /r/<name>.json — a single resolved registry item with inlined file
// contents, installable via `npx shadcn add <origin>/r/<name>.json`.
export const GET = async (_request: Request, { params }: RouteContext) => {
  const { component } = await params;

  if (!component.endsWith(".json")) {
    return NextResponse.json(
      { error: "Component must end with .json" },
      { status: 400 }
    );
  }

  const name = component.slice(0, -".json".length);
  const item = await getRegistryItem(name);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(item);
};

export const generateStaticParams = async () => {
  const items = await getRegistryItems();
  return items.map((item) => ({ component: `${item.name}.json` }));
};
