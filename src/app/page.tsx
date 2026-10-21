import { edition } from "@/edition";
import ExplorePage from "./explore/page";

export default async function HomePage(props: { searchParams: Promise<{ q?: string }> }) {
  const Home = edition.homePage;
  return Home ? <Home /> : ExplorePage(props);
}
