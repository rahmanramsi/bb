import { z } from "zod";

export const projectVisibilityValues = ["public", "private"] as const;
export const projectVisibilitySchema = z.enum(projectVisibilityValues);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;
export const DEFAULT_PROJECT_VISIBILITY: ProjectVisibility = "public";
