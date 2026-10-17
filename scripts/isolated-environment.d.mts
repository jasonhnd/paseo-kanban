export function executable(name: string, path?: string): string;
export const TEST_TOOLS: string[];
export function isolatedEnvironment(directory: string, options?: { release?: boolean; voice?: boolean; sourceEnv?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv;
export function testHostConfig(overrides?: { daemon?: Record<string, unknown>; features?: Record<string, unknown> }): Record<string, unknown>;
