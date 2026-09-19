import { TMDBRegion, TMDBMovieSearchResult, TMDBSearchResponse, TMDBWatchProviderResponse } from './types';
import { logger } from './utils/logger';

export class TMDBError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = 'TMDBError';
    }
}

function normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class TMDBClient {
    private readonly baseUrl = 'https://api.themoviedb.org/3';
    private readonly headers: Record<string, string>;
    private lastCallTime = 0;

    // Adaptive rate limiting
    private minRPS = 1;
    private maxRPS = 30;
    private rps = 10;

    /**
     * Either credential works for the v3 endpoints used here: the read access
     * token is sent as a Bearer header, the API key as a query parameter.
     */
    constructor(private apiKey?: string, private readApiKey?: string) {
        this.headers = { 'accept': 'application/json' };
        if (readApiKey) this.headers['Authorization'] = `Bearer ${readApiKey}`;
    }

    get hasCredentials(): boolean {
        return !!(this.apiKey || this.readApiKey);
    }

    private buildUrl(path: string, params: Record<string, string> = {}): string {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        if (!this.readApiKey && this.apiKey) url.searchParams.set('api_key', this.apiKey);
        return url.toString();
    }

    private async adaptiveFetch(url: string): Promise<Response> {
        await this.rateLimit();
        const response = await fetch(url, { headers: this.headers });
        if (response.status === 429) {
            this.rps = Math.max(this.rps - 2, this.minRPS);
            logger.warn(`[TMDBClient] 429 received, reducing RPS to ${this.rps}`);
        } else if (response.ok) {
            if (this.rps < this.maxRPS) {
                this.rps = Math.min(this.maxRPS, this.rps + 1);
                logger.debug(`[TMDBClient] Success, increasing RPS to ${this.rps}`);
            }
        }
        if (!response.ok) {
            throw new TMDBError(`TMDB request failed: ${response.status}`, response.status);
        }
        return response;
    }

    async searchMovie(title: string, year?: number): Promise<TMDBMovieSearchResult | null> {
        const params: Record<string, string> = {
            query: title,
            include_adult: 'false',
            language: 'en-US',
            page: '1',
        };
        if (year) params.year = year.toString();

        const response = await this.adaptiveFetch(this.buildUrl('/search/movie', params));
        const data: TMDBSearchResponse = await response.json();
        if (!data.results?.length) {
            logger.warn(`[searchMovie] No results found for "${title}"${year ? ` (${year})` : ''}`);
            return null;
        }

        // Prefer exact title matches, then the most popular result
        const wanted = normalizeTitle(title);
        const isExact = (m: TMDBMovieSearchResult) =>
            normalizeTitle(m.title) === wanted || normalizeTitle(m.original_title || '') === wanted;
        return [...data.results].sort((a, b) =>
            Number(isExact(b)) - Number(isExact(a)) || b.popularity - a.popularity
        )[0];
    }

    async getAvailableCountries(): Promise<TMDBRegion[]> {
        const response = await this.adaptiveFetch(this.buildUrl('/watch/providers/regions'));
        const regions: TMDBRegion[] = (await response.json()).results || [];
        return regions.sort((a, b) => a.english_name.localeCompare(b.english_name));
    }

    async getStreamingProviders(movieId: number, countryCode: string): Promise<string[]> {
        const response = await this.adaptiveFetch(this.buildUrl(`/movie/${movieId}/watch/providers`));
        const data: TMDBWatchProviderResponse = await response.json();
        const countryData = data.results?.[countryCode] || {};
        return countryData.flatrate?.map(p => p.provider_name.toLowerCase()) || [];
    }

    private async rateLimit(): Promise<void> {
        const now = Date.now();
        const delay = Math.max(0, 1000 / this.rps - (now - this.lastCallTime));
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        this.lastCallTime = Date.now();
    }
}
