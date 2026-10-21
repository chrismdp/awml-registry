import { getAuth } from "@/server/auth";

const handle = async (req: Request) => (await getAuth()).handler(req);

export { handle as GET, handle as POST };
