/**
 * Connections are opened lazily inside the test workers and closed by each
 * suite's `afterAll(destroyAll)`; jest's `forceExit` reaps anything left. The
 * main process opens none, so there is nothing to close here.
 */
export default async function teardown(): Promise<void> {
    // intentionally empty
}
