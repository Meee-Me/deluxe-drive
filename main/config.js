// Where Deluxe Main's server answers. It runs inside the Deluxe Cloudflare
// Worker, under /main. Served from there, these pages use their own address;
// a copy elsewhere (Vercel) talks to the Worker; a local dev server answers on
// its own address.
window.DELUXE_MAIN_API = /^\/main(\/|$)/.test(location.pathname)
  ? location.origin + '/main'
  : /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? ''
    : 'https://deluxe-drive.deluxelordd.workers.dev/main';
