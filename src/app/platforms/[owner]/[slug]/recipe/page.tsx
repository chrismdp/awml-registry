import { movedPlatform } from "../load";

export default async function OldPlatformRecipePage({ params }: { params: Promise<{ owner: string; slug: string }> }) {
  const { owner, slug } = await params;
  return movedPlatform(owner, slug, "latest", "recipe");
}
