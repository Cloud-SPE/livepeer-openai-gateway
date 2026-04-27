// @cloud-spe/bridge-core — public API barrel.
//
// Shell consumers reach engine symbols via subpath imports
// (`@cloud-spe/bridge-core/<subpath>`) rather than re-exporting everything
// here. The root barrel is intentionally minimal — a comprehensive
// re-export ladder is a step-4-stage cleanup once the shell package
// finalizes its consumption pattern.
export {};
