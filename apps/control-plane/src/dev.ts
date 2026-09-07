export {};

const { applyLocalDevelopmentDefaults } = await import("./local-dev.ts");
applyLocalDevelopmentDefaults();

await import("./index.ts");
