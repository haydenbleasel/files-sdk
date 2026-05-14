import { TableOfContents } from "@/components/table-of-contents";
import { getChangelog } from "@/lib/changelog";

const UpdatesToc = () => {
  const sections = getChangelog().map((release) => ({
    id: release.slug,
    label: `v${release.version}`,
  }));
  return <TableOfContents sections={sections} />;
};

export default UpdatesToc;
