export function executable(name: string, path?: string): string;
export const TEST_TOOLS: string[];
export function isolatedEnvironment(directory: string, options?: { release?: boolean; sourceEnv?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv;
