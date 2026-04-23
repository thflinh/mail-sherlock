/// <reference types="vite/client" />

interface Window {
  dataLayer: unknown[];
  gtag: (...args: unknown[]) => void;
}

declare module "*.png" {
  const src: string;
  export default src;
}
