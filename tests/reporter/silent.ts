import { DotReporter } from 'vitest/node'

export default class SilentReporter extends DotReporter {

  onTestCaseReady() {}
  onTestCaseResult() {}

  onTestRunEnd(...args: Parameters<DotReporter['onTestRunEnd']>) {
    super.onTestRunEnd(...args)
    // Delay to ensure this prints after DotReporter's summary
    setTimeout(() => console.log('[TESTS:DONE]'), 100)
  }

}
