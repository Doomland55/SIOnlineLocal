// Configuration of the SIGame web client for the local server.
//
// This file is loaded by the web client before the application starts.
// The local server serves it at /config.js, so the client always talks to the server it was loaded from.
const LOCAL_SERVER_URI = window.location.origin;

config = {
    // Do not use the central server discovery: the local server is the only server
    serverUri: LOCAL_SERVER_URI,
    serverDiscoveryUri: '',
    rootUri: '/',
    ads: '<b></b>',
    rewriteUrl: true,
    forceHttps: false,
    registerServiceWorker: false,
    enableNoSleep: false,
    askForConsent: false,
    // Services that are not available locally are disabled: their requests are not sent
    siStatisticsServiceUri: '',
    appRegistryServiceUri: '',
    clearUrls: false
};

firebaseConfig = null;

onLoad = function () {
    console.log('SIGame successfully loaded (local server: ' + LOCAL_SERVER_URI + ')');
};
