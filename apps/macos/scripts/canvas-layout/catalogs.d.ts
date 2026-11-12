/** The compiled Lingui messages the build embeds, by locale (see build.mjs). */
declare module 'canvas-lingui-catalogs' {
  const catalogs: Record<string, Record<string, unknown>>;
  export default catalogs;
}
