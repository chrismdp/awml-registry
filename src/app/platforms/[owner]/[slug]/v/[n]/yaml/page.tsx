import { movedPlatform } from "../../../load";

export default async function OldPlatformVersionYamlPage({ params }: { params: Promise<{ owner: string; slug: string; n: string }> }) {
  const { owner, slug, n } = await params;
  return movedPlatform(owner, slug, n, "yaml");
}
