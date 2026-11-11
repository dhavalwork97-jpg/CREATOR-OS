// Explicit Vercel route for the scheduled worker tick.
import handler, { config } from "../../lib/api-handler.mjs";
export { config };
export default handler;
