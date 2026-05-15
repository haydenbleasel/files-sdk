import { TableOfContents } from "@/components/table-of-contents";
import { getAdapter } from "@/lib/adapters";

interface AdapterDetailTocProps {
  params: Promise<{ slug: string }>;
}

const AdapterDetailToc = async ({ params }: AdapterDetailTocProps) => {
  const { slug } = await params;
  const adapter = getAdapter(slug);

  if (!adapter || adapter.sections.length === 0) {
    return null;
  }

  return <TableOfContents sections={adapter.sections} />;
};

export default AdapterDetailToc;
