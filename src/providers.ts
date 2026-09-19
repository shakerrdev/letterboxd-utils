/**
 * Maps the provider keys stored in settings (see options.html) to patterns
 * matching TMDB's provider names, e.g. "amazon" -> "Amazon Prime Video".
 * TMDB names vary per region and include tiers/channels
 * ("Netflix basic with Ads", "Paramount+ with Showtime"), so exact
 * comparison is not enough.
 */
const PROVIDER_PATTERNS: { [key: string]: RegExp } = {
    netflix: /^netflix\b/,
    hulu: /^hulu\b/,
    amazon: /^amazon prime video\b/,
    disney: /^disney( plus|\+)/,
    hbo: /^(hbo( max)?|max)(\s|$)/,
    apple: /^apple tv( plus|\+|$)/,
    paramount: /^paramount( plus|\+)/,
    peacock: /^peacock\b/,
};

export function providerMatches(key: string, providerName: string): boolean {
    const name = providerName.trim().toLowerCase();
    const pattern = PROVIDER_PATTERNS[key.toLowerCase()];
    return pattern ? pattern.test(name) : name === key.toLowerCase();
}

export function hasAnyProvider(providerNames: string[], keys: string[]): boolean {
    return providerNames.some(name => keys.some(key => providerMatches(key, name)));
}
