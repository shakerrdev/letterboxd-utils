/**
 * Core extension settings stored in browser.storage.local
 */
export interface ExtensionSettings {
    tmdbApiKey: string;
    tmdbReadApiKey?: string;
    selectedProviders?: string[];
    countryCode?: string;
    unavailableOpacity?: number;
    fadeUnavailable?: boolean;
    trueRatingsStats?: boolean;
}

/**
 * TMDB API response types
 */
export interface TMDBRegion {
    iso_3166_1: string;
    english_name: string;
    native_name: string;
}

export interface TMDBMovieSearchResult {
    id: number;
    title: string;
    original_title?: string;
    release_date?: string;
    popularity: number;
}

export interface TMDBSearchResponse {
    page: number;
    results: TMDBMovieSearchResult[];
    total_pages: number;
    total_results: number;
}

export interface Provider {
    provider_id: number;
    provider_name: string;
    logo_path: string;
}

export interface ProviderCountry {
    flatrate?: Provider[];
}

export interface TMDBWatchProviderResponse {
    id: number;
    results: {
        [countryCode: string]: ProviderCountry;
    };
}

/**
 * Error handling types
 */
export interface ExtensionError extends Error {
    userFriendly?: string;
    isRecoverable?: boolean;
}

/**
 * Utility types
 */
export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;