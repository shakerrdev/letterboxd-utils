import { TMDBClient, TMDBError } from './tmdb';
import { TMDBRegion } from './types';
import { logger } from './utils/logger';

let cachedCountries: TMDBRegion[] = [];
let cachedAt: number = 0;
const COUNTRY_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

export async function getCountries(): Promise<TMDBRegion[]> {
    const now = Date.now();
    if (cachedCountries?.length && (now - cachedAt < COUNTRY_CACHE_TTL)) {
        logger.debug(`[Background] Returning cached countries (age: ${(now - cachedAt) / 1000}s)`);
        return cachedCountries;
    }

    const result = await browser.storage.local.get(['tmdbApiKey', 'tmdbReadApiKey']);
    if (!result.tmdbApiKey && !result.tmdbReadApiKey) {
        logger.warn(`[Background] TMDB API key not set. Cannot fetch countries.`);
        return [];
    }

    try {
        const tmdb = new TMDBClient(result.tmdbApiKey, result.tmdbReadApiKey);
        const countries = await tmdb.getAvailableCountries();
        if (countries.length) {
            cachedCountries = countries;
            cachedAt = Date.now();
        }
        logger.info(`[Background] Fetched ${countries.length} countries from TMDB`);
        return countries;
    } catch (error) {
        logger.error(`[Background] Failed to fetch countries from TMDB: ${error}`);
        throw error;
    }
}

logger.info("[Background] Script loaded");

browser.runtime.onMessage.addListener(async (request) => {
    if (request.action === 'getCountries') {
        try {
            return await getCountries();
        } catch (error) {
            logger.error(`[Background] Country fetch failed: ${error}`);
            if (error instanceof TMDBError && error.status === 401) {
                return { error: 'TMDB rejected the API key. Check that it is correct.' };
            }
            return { error: 'Failed to load countries' };
        }
    }
    return undefined;
});

// Keys changed: the cached list may have been fetched with other credentials
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.tmdbApiKey || changes.tmdbReadApiKey)) {
        cachedCountries = [];
        cachedAt = 0;
    }
});
