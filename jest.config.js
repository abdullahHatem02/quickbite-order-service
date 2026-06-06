module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests/unit'],
    testMatch: ['**/*.test.ts'],
    setupFiles: ['<rootDir>/tests/setup-env.ts'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {tsconfig: 'tsconfig.test.json'}],
    },
};
