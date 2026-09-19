// Histogram bars are ordered 0.5, 1, 1.5, ..., 5
export const RATING_VALUES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

export type RatingsStats = {
    mean: number;
    median: number;
    mode: number[];
    stddev: number;
    n: number;
};

/**
 * Parses a histogram bar label such as "1,343 half-★ ratings (0%)" or
 * "3,808 ★ ratings (1%)" into its count.
 */
export function parseBarCount(text: string): number {
    const match = text.match(/([\d,]+)[^\d]+ratings?/);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) || 0 : 0;
}

/**
 * Computes stats directly from per-rating counts, without expanding the
 * histogram into one entry per rating (films can have millions of ratings).
 */
export function calcStats(counts: number[], values: number[] = RATING_VALUES): RatingsStats | null {
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) return null;

    const mean = counts.reduce((acc, c, i) => acc + c * values[i], 0) / n;
    const variance = counts.reduce((acc, c, i) => acc + c * Math.pow(values[i] - mean, 2), 0) / n;

    // Value at a 0-based position in the sorted ratings
    const valueAt = (pos: number): number => {
        let seen = 0;
        for (let i = 0; i < counts.length; i++) {
            seen += counts[i];
            if (pos < seen) return values[i];
        }
        return values[values.length - 1];
    };
    const median = n % 2 === 0
        ? (valueAt(n / 2 - 1) + valueAt(n / 2)) / 2
        : valueAt(Math.floor(n / 2));

    const maxCount = Math.max(...counts);
    const mode = values.filter((_, i) => counts[i] === maxCount);

    return { mean, median, mode, stddev: Math.sqrt(variance), n };
}
