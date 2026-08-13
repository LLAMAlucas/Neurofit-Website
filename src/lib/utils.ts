import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn class merger: conditional classes via clsx, conflict
 *  resolution via tailwind-merge (so a later `p-8` beats an earlier `p-4`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
