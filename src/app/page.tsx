import { edition } from "@/edition";
import GalleryPage from "./gallery/page";

export default async function HomePage(props: { searchParams: Promise<{ q?: string }> }) {
  const Home = edition.homePage;
  return Home ? <Home /> : GalleryPage(props);
}
