import { AsyncLocalStorage } from 'async_hooks';

/**
 * Server base url that the current request has been made to.
 *
 * The local server could be reached by different addresses (localhost, a LAN IP, a preview url).
 * Game links and media urls are built from the address the client has used, so they always work.
 */
export const requestBaseUrl = new AsyncLocalStorage<string>();
