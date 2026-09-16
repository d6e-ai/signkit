import { writable, type Writable } from 'svelte/store';

/**
 * The envelope editor loads its instance-authorized detail in the browser.
 * This small client-side bridge lets the persistent application header show
 * that loaded title without duplicating the detail request in a layout load.
 */
export const envelopeBreadcrumbTitle: Writable<string | null> = writable(null);
