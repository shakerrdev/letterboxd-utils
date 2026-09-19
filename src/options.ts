import { DEFAULT_COUNTRY, DEFAULT_OPACITY, DEFAULT_PROVIDERS } from './constants';
import { ExtensionSettings, TMDBRegion } from './types';
import { logger } from './utils/logger';

function input(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement;
}

async function saveOptions() {
    const saveBtn = document.getElementById('save') as HTMLButtonElement;
    logger.info(`[Options] Saving options...`);
    saveBtn.disabled = true;
    const apiKey = input('apiKey').value.trim();
    const readApiKey = input('readApiKey').value.trim();
    const providerCheckboxes = document.querySelectorAll<HTMLInputElement>(
        'input[name="provider"]:checked'
    );
    const countrySelect = document.getElementById('country') as HTMLSelectElement;

    const settings: Partial<ExtensionSettings> = {
        tmdbApiKey: apiKey,
        tmdbReadApiKey: readApiKey,
        selectedProviders: Array.from(providerCheckboxes).map(cb => cb.value),
        unavailableOpacity: parseFloat(input('opacity').value),
        fadeUnavailable: input('fadeToggle').checked,
        trueRatingsStats: input('trueRatingsStats').checked
    };
    // Don't overwrite the saved country while the list couldn't be loaded
    if (!countrySelect.disabled && countrySelect.value) {
        settings.countryCode = countrySelect.value;
    }

    try {
        const previous = await browser.storage.local.get(['tmdbApiKey', 'tmdbReadApiKey']);
        await browser.storage.local.set(settings);
        showStatus('Settings saved successfully!', 'success');

        // Reload countries when the keys changed
        if (previous.tmdbApiKey !== apiKey || previous.tmdbReadApiKey !== readApiKey) {
            await loadCountries();
        }
    } catch (error) {
        logger.error(`[Options] Error saving settings: ${error}`);
        showStatus('Failed to save settings', 'error');
    } finally {
        saveBtn.disabled = false;
    }
}

async function loadOptions() {
    try {
        const result = await browser.storage.local.get([
            'tmdbApiKey', 'tmdbReadApiKey', 'selectedProviders', 'unavailableOpacity', 'fadeUnavailable',
            'trueRatingsStats'
        ]) as Partial<ExtensionSettings>;

        input('apiKey').value = result.tmdbApiKey || '';
        input('readApiKey').value = result.tmdbReadApiKey || '';

        const selected = result.selectedProviders || DEFAULT_PROVIDERS;
        document.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach(checkbox => {
            checkbox.checked = selected.includes(checkbox.value);
        });

        const opacity = typeof result.unavailableOpacity === 'number' ? result.unavailableOpacity : DEFAULT_OPACITY;
        const fade = result.fadeUnavailable !== false;
        input('opacity').value = opacity.toString();
        input('opacity').disabled = !fade;
        (document.getElementById('opacity-value') as HTMLElement).textContent = opacity.toString();
        input('fadeToggle').checked = fade;
        input('trueRatingsStats').checked = result.trueRatingsStats === true;
    } catch (error) {
        logger.error(`[Options] Error loading settings: ${error}`);
    }
}

function setCountryPlaceholder(select: HTMLSelectElement, text: string) {
    select.replaceChildren(new Option(text, ''));
    select.disabled = true;
}

async function loadCountries() {
    const select = document.getElementById('country') as HTMLSelectElement;
    const countryError = document.getElementById('country-error')!;
    setCountryPlaceholder(select, 'Loading countries...');
    countryError.textContent = '';
    try {
        const { tmdbApiKey, tmdbReadApiKey } = await browser.storage.local.get(['tmdbApiKey', 'tmdbReadApiKey']);
        if (!tmdbApiKey && !tmdbReadApiKey) {
            setCountryPlaceholder(select, 'Set a TMDB API key first');
            countryError.textContent = 'Save a TMDB API key or read token to enable country selection.';
            return;
        }

        const response = await browser.runtime.sendMessage({ action: 'getCountries' });
        if (!Array.isArray(response)) throw new Error(response?.error || 'Failed to load countries');
        if (!response.length) throw new Error('TMDB returned no countries');
        logger.debug(`[Options] ${response.length} countries loaded`);

        select.replaceChildren(...response.map((c: TMDBRegion) => new Option(c.english_name, c.iso_3166_1)));
        const saved = await browser.storage.local.get('countryCode');
        select.value = saved.countryCode || DEFAULT_COUNTRY;
        select.disabled = false;
    } catch (error: any) {
        logger.error(`[Options] Country load failed: ${error}`);
        setCountryPlaceholder(select, 'Countries unavailable');
        countryError.textContent = error.message;
    }
}

let statusTimer: number | undefined;

function showStatus(message: string, type: 'success' | 'error') {
    const status = document.getElementById('status')!;
    status.textContent = message;
    status.className = `status-message ${type}`;
    clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => status.textContent = '', 3000);
}

document.addEventListener('DOMContentLoaded', async () => {
    const opacityInput = input('opacity');
    const opacityValue = document.getElementById('opacity-value') as HTMLElement;
    opacityInput.addEventListener('input', () => {
        opacityValue.textContent = opacityInput.value;
    });

    const fadeToggle = input('fadeToggle');
    fadeToggle.addEventListener('change', () => {
        opacityInput.disabled = !fadeToggle.checked;
    });

    document.getElementById('save')?.addEventListener('click', saveOptions);

    await loadOptions();
    await loadCountries();
});
