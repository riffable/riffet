import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, the later Tailwind utility winning, as the app's own `cn` does. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
