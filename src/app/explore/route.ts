// The gallery moved to /gallery. Old links and searches go there for good.
export async function GET(req: Request) {
  const { search } = new URL(req.url);
  return new Response(null, { status: 308, headers: { location: `/gallery${search}` } });
}
