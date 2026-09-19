import { DEFAULT_COUNTRY, DEFAULT_OPACITY, DEFAULT_PROVIDERS } from './constants';
import { hasAnyProvider } from './providers';
import { calcStats, parseBarCount } from './ratings-stats';
import { TMDBClient, TMDBError } from './tmdb'
import { ExtensionSettings } from './types'
import { logger } from './utils/logger';

const CACHE_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours
// Expired entries are still shown while re-fetching; drop them after this
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHE_PERSIST_DELAY_MS = 2000;

type MovieCacheEntry = {
    tmdbId?: number;
    providers?: string[];
    timestamp: number;
};

type MovieCache = { [key: string]: MovieCacheEntry };

type MovieElementInfo = {
    element: HTMLElement;
    title: string;
    year: string;
    cacheKey: string;
};

const SETTINGS_KEYS = [
    'tmdbApiKey', 'tmdbReadApiKey', 'selectedProviders', 'countryCode',
    'unavailableOpacity', 'fadeUnavailable', 'trueRatingsStats'
];

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class StreamFilter {
    private tmdb: TMDBClient;
    private targetProviders: string[] = [];
    private countryCode = DEFAULT_COUNTRY;
    private memoryCache: MovieCache = {};
    private cacheLoaded: Promise<void>;
    private dirtyKeys = new Set<string>();
    private persistTimer: number | null = null;
    private processedElements = new WeakSet<HTMLElement>();
    private debounceTimer: number | null = null;
    private authFailed = false;
    private observer: MutationObserver | null = null;
    private stopped = false;

    constructor(apiKey: string | undefined, readApiKey: string | undefined, providers: string[], countryCode: string) {
        this.tmdb = new TMDBClient(apiKey, readApiKey);
        this.setFilter(providers, countryCode);
        this.cacheLoaded = browser.storage.local.get('movieCache')
            .then(res => { this.memoryCache = res.movieCache || {}; })
            .catch(error => logger.error(`[StreamFilter] Failed to load cache: ${error}`));
    }

    private setFilter(providers: string[], countryCode: string): void {
        logger.info(`[StreamFilter] Filtering for providers: ${providers} in ${countryCode}`);
        this.targetProviders = providers.map(p => p.toLowerCase());
        this.countryCode = countryCode;
    }

    /** Re-applies the filter to every poster, e.g. after settings changed. */
    public async updateFilter(providers: string[], countryCode: string): Promise<void> {
        this.setFilter(providers, countryCode);
        this.processedElements = new WeakSet();
        await this.processAllMovies(this.findPosters());
    }

    private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            const status = error instanceof TMDBError ? error.status : 0;
            // Client errors other than rate limiting won't succeed on retry
            if (retries <= 0 || (status >= 400 && status < 500 && status !== 429)) throw error;
            logger.warn(`[withRetry] ${error}, retrying...`);
            await sleep(status === 429 ? 2000 : 500);
            return this.withRetry(fn, retries - 1);
        }
    }

    private normalizeTitle(title: string): string {
        return title
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private getCacheKey(title: string, year: string): string {
        // Providers differ per country, so the country is part of the key
        return `${this.countryCode}:${this.normalizeTitle(title)}-${year}`;
    }

    private setMovieCache(key: string, entry: MovieCacheEntry): void {
        this.memoryCache[key] = entry;
        this.dirtyKeys.add(key);
        if (this.persistTimer === null) {
            this.persistTimer = window.setTimeout(() => this.persistCache(), CACHE_PERSIST_DELAY_MS);
        }
    }

    /** Writes changed entries, merging with what other tabs may have stored. */
    private async persistCache(): Promise<void> {
        this.persistTimer = null;
        const keys = Array.from(this.dirtyKeys);
        this.dirtyKeys.clear();
        try {
            const res = await browser.storage.local.get('movieCache');
            const stored: MovieCache = res.movieCache || {};
            for (const key of keys) stored[key] = this.memoryCache[key];

            const now = Date.now();
            for (const key of Object.keys(stored)) {
                if (!stored[key] || now - stored[key].timestamp > CACHE_MAX_AGE_MS) delete stored[key];
            }
            await browser.storage.local.set({ movieCache: stored });
        } catch (error) {
            logger.error(`[StreamFilter] Failed to persist cache: ${error}`);
        }
    }

    private getMovieElementInfo(element: HTMLElement): MovieElementInfo | null {
        // Posters are rendered by a React component whose wrapper carries the
        // name as "Title (Year)"; the frame title is filled in later.
        const wrapper = element.closest<HTMLElement>('[data-item-full-display-name], [data-item-name]');
        let title = wrapper?.dataset.itemFullDisplayName
            || wrapper?.dataset.itemName
            || element.querySelector('.frame-title')?.textContent?.trim()
            || '';
        const yearMatch = title.match(/\((\d{4})\)\s*$/);
        const year = yearMatch ? yearMatch[1] : '';
        if (yearMatch) {
            title = title.slice(0, yearMatch.index).trim();
        }
        if (!title) return null;
        return { element, title, year, cacheKey: this.getCacheKey(title, year) };
    }

    private async processMovieWithTMDB(info: MovieElementInfo): Promise<void> {
        if (this.authFailed || this.stopped) return;
        try {
            const movie = await this.withRetry(() =>
                this.tmdb.searchMovie(info.title, info.year ? parseInt(info.year) : undefined)
            );
            if (!movie) {
                this.setMovieCache(info.cacheKey, { timestamp: Date.now(), providers: [] });
                this.updateElement(info.element, []);
                return;
            }
            const providers = await this.withRetry(() =>
                this.tmdb.getStreamingProviders(movie.id, this.countryCode)
            );
            this.setMovieCache(info.cacheKey, {
                tmdbId: movie.id,
                providers,
                timestamp: Date.now()
            });
            this.updateElement(info.element, providers);
        } catch (error) {
            // Leave the poster as it is: a failed lookup says nothing about availability
            logger.error(`[StreamFilter] Lookup failed for "${info.title}": ${error}`);
            if (error instanceof TMDBError && error.status === 401) {
                this.authFailed = true;
                showWarning('<strong>TMDB rejected the API key.</strong> Check it in the extension settings.');
            }
        }
    }

    private isCacheExpired(entry: MovieCacheEntry): boolean {
        return Date.now() - entry.timestamp >= CACHE_LIFETIME_MS;
    }

    private findPosters(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>('.film-poster'));
    }

    private async processAllMovies(elements: HTMLElement[]): Promise<void> {
        await this.cacheLoaded;

        const uncached: MovieElementInfo[] = [];
        const expired: MovieElementInfo[] = [];
        for (const el of elements) {
            if (this.processedElements.has(el)) continue;
            const info = this.getMovieElementInfo(el);
            // No title yet: the poster is still rendering, retry on a later mutation
            if (!info) continue;
            // Mark now so overlapping runs don't look the same poster up twice
            this.processedElements.add(el);

            const cached = this.memoryCache[info.cacheKey];
            if (cached?.providers) {
                this.updateElement(el, cached.providers);
                if (this.isCacheExpired(cached)) expired.push(info);
            } else {
                uncached.push(info);
            }
        }

        // Uncached first, then refresh expired entries (both rate-limited by the client)
        for (const info of [...uncached, ...expired]) {
            await this.processMovieWithTMDB(info);
        }
    }

    public async observePage(): Promise<void> {
        this.observer = new MutationObserver(() => {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = window.setTimeout(() => {
                const newElements = this.findPosters().filter(el => !this.processedElements.has(el));
                if (newElements.length > 0) this.processAllMovies(newElements);
            }, 400);
        });
        this.observer.observe(document.body, { childList: true, subtree: true });

        await this.processAllMovies(this.findPosters());
    }

    public stop(): void {
        this.stopped = true;
        this.observer?.disconnect();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
    }

    private updateElement(element: HTMLElement, providers: string[]): void {
        const isAvailable = hasAnyProvider(providers, this.targetProviders);
        element.classList.toggle('unavailable-movie', !isAvailable);
    }
}

function showWarning(html: string): void {
    const warningId = 'letterboxd-utils-warning';
    let warning = document.getElementById(warningId);
    if (!warning) {
        warning = document.createElement('div');
        warning.id = warningId;
        warning.className = 'letterboxd-utils-warning';
        warning.title = 'Click to dismiss';
        warning.addEventListener('click', () => warning?.remove());
        document.body.appendChild(warning);
    }
    warning.innerHTML = html;
}

function hideWarning(): void {
    document.getElementById('letterboxd-utils-warning')?.remove();
}

// --- FADING ---
function getOpacity(settings: Partial<ExtensionSettings>): number {
    if (settings.fadeUnavailable === false) return 1;
    return typeof settings.unavailableOpacity === 'number' ? settings.unavailableOpacity : DEFAULT_OPACITY;
}

function applyFadeSettings(settings: Partial<ExtensionSettings>): void {
    document.documentElement.style.setProperty('--unavailable-movie-opacity', getOpacity(settings).toString());
    const fade = settings.fadeUnavailable !== false;
    document.querySelectorAll<HTMLElement>('.fade-toggle-navitem a').forEach(btn => {
        btn.setAttribute('aria-pressed', fade ? 'true' : 'false');
        const label = btn.querySelector('.label');
        if (label) label.textContent = fade ? 'Fading: ON' : 'Fading: OFF';
    });
}

// Add a toggle button to the nav bar for fading unavailable movies
function addFadeToggleToNav(settings: Partial<ExtensionSettings>, attempts = 20): void {
    const nav = document.querySelector('ul.navitems');
    if (!nav) {
        if (attempts > 0) setTimeout(() => addFadeToggleToNav(settings, attempts - 1), 500);
        return;
    }
    if (nav.querySelector('.fade-toggle-navitem')) return;

    const li = document.createElement('li');
    li.className = 'navitem fade-toggle-navitem main-nav-fade';

    const btn = document.createElement('a');
    btn.href = '#';
    btn.className = 'navlink has-icon';
    btn.setAttribute('role', 'button');

    const label = document.createElement('span');
    label.className = 'label';
    btn.appendChild(label);
    li.appendChild(btn);

    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const res = await browser.storage.local.get('fadeUnavailable');
        // The storage listener applies the change
        await browser.storage.local.set({ fadeUnavailable: res.fadeUnavailable === false });
    });

    // Insert after Activity nav item
    const activityNav = nav.querySelector('.main-nav-activity');
    nav.insertBefore(li, activityNav ? activityNav.nextSibling : null);
    applyFadeSettings(settings);
}

// --- TRUE RATINGS STATS ---
const RATINGS_SECTION_SELECTOR = '.section.ratings-histogram-chart:not(.imdb-ratings):not(.tomato-ratings):not(.meta-ratings)';

function parseRatingsHistogram(section: Element): number[] | null {
    const bars = section.querySelectorAll('li.rating-histogram-bar');
    if (!bars.length) return null;
    return Array.from(bars).map(bar => {
        const a = bar.querySelector('a');
        const text = a?.getAttribute('data-original-title') || a?.getAttribute('title')
            || bar.getAttribute('data-original-title') || bar.getAttribute('title')
            || bar.textContent || '';
        return parseBarCount(text);
    });
}

function formatRating(value: number): string {
    return value.toFixed(2).replace(/\.?0+$/, '');
}

function injectTrueRatingsStats(): void {
    const origSection = document.querySelector(RATINGS_SECTION_SELECTOR);
    if (!origSection) return;
    if (origSection.nextElementSibling?.classList.contains('true-ratings-stats-section')) return;

    const counts = parseRatingsHistogram(origSection);
    if (!counts) return;
    const stats = calcStats(counts);
    if (!stats) return;

    const statsSection = document.createElement('section');
    statsSection.className = 'section true-ratings-stats-section';

    const heading = document.createElement('h2');
    heading.className = 'section-heading';
    heading.textContent = 'True Ratings Stats';

    const statsDiv = document.createElement('div');
    statsDiv.className = 'true-ratings-stats';
    const rows: [string, string][] = [
        ['True average', stats.mean.toFixed(2)],
        ['Median', formatRating(stats.median)],
        ['Mode', stats.mode.map(formatRating).join(', ')],
        ['Standard deviation', stats.stddev.toFixed(2)],
        ['Total ratings', stats.n.toLocaleString()],
    ];
    for (const [name, value] of rows) {
        const row = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = `${name}: `;
        row.append(strong, value);
        statsDiv.appendChild(row);
    }

    statsSection.append(heading, statsDiv);
    origSection.after(statsSection);
}

function observeRatingsStatsFeature(initiallyEnabled: boolean): void {
    // Ratings histograms only exist on film pages
    if (!location.pathname.startsWith('/film/')) return;
    let enabled = initiallyEnabled;
    if (enabled) injectTrueRatingsStats();

    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.trueRatingsStats) {
            enabled = !!changes.trueRatingsStats.newValue;
            if (enabled) injectTrueRatingsStats();
            else document.querySelectorAll('.true-ratings-stats-section').forEach(e => e.remove());
        }
    });

    // The histogram is loaded asynchronously, so inject once it appears
    const observer = new MutationObserver(() => {
        if (enabled) injectTrueRatingsStats();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// --- INIT ---
let streamFilter: StreamFilter | null = null;

function startStreamFilter(settings: Partial<ExtensionSettings>): void {
    if (!settings.tmdbApiKey && !settings.tmdbReadApiKey) {
        showWarning('<strong>TMDB API key required!</strong> Configure it in the extension settings.');
        return;
    }
    hideWarning();
    streamFilter = new StreamFilter(
        settings.tmdbApiKey,
        settings.tmdbReadApiKey,
        settings.selectedProviders || DEFAULT_PROVIDERS,
        settings.countryCode || DEFAULT_COUNTRY
    );
    streamFilter.observePage();
}

browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !Object.keys(changes).some(key => SETTINGS_KEYS.includes(key))) return;
    const settings = await browser.storage.local.get(SETTINGS_KEYS) as Partial<ExtensionSettings>;

    if (changes.fadeUnavailable || changes.unavailableOpacity) {
        applyFadeSettings(settings);
    }
    if (changes.tmdbApiKey || changes.tmdbReadApiKey) {
        // New credentials: start over with a fresh client
        streamFilter?.stop();
        streamFilter = null;
        startStreamFilter(settings);
    } else if (streamFilter && (changes.selectedProviders || changes.countryCode)) {
        streamFilter.updateFilter(
            settings.selectedProviders || DEFAULT_PROVIDERS,
            settings.countryCode || DEFAULT_COUNTRY
        );
    }
});

logger.info('[ContentScript] Initializing extension...');
browser.storage.local.get(SETTINGS_KEYS)
    .then(result => {
        const settings = result as Partial<ExtensionSettings>;
        applyFadeSettings(settings);
        addFadeToggleToNav(settings);
        observeRatingsStatsFeature(!!settings.trueRatingsStats);
        startStreamFilter(settings);
    })
    .catch(error => {
        logger.error(`[ContentScript] Error loading settings: ${error}`);
    });
