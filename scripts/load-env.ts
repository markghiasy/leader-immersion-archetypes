import { config } from "dotenv";

/**
 * Load environment the same way Next.js does, so `npm run db:migrate` and `npm run seed`
 * see exactly what `npm run dev` sees. `.env.local` wins over `.env`; neither is required
 * when the variables are already exported (CI, or a one-off DATABASE_URL=… prefix).
 */
config({ path: [".env.local", ".env"] });
