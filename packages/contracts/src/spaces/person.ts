import * as z from "zod";
import { Id } from "../ids.js";

export const PersonSchema = z.object({
  userId: Id,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});
