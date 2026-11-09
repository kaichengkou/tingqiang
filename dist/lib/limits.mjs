export const MAX_BROWSER_SEPARATION_SECONDS = 600;
export function browserSeparationAllowed(duration) { return Number.isFinite(duration) && duration > 0 && duration <= MAX_BROWSER_SEPARATION_SECONDS; }
