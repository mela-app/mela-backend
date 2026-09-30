import { KeyedThrottle } from './keyed-throttle';

describe('KeyedThrottle', () => {
  let runs: string[];
  let throttle: KeyedThrottle;

  beforeEach(() => {
    jest.useFakeTimers();
    runs = [];
    throttle = new KeyedThrottle(2000, (key) => runs.push(key));
  });

  afterEach(() => jest.useRealTimers());

  it('runs the first call at once', () => {
    throttle.schedule('a');

    expect(runs).toEqual(['a']);
  });

  it('collapses a burst into exactly one trailing run at the end of the window', () => {
    throttle.schedule('a');
    jest.advanceTimersByTime(500);
    throttle.schedule('a');
    throttle.schedule('a');
    throttle.schedule('a');
    expect(runs).toEqual(['a']);

    jest.advanceTimersByTime(1499);
    expect(runs).toEqual(['a']);
    jest.advanceTimersByTime(1);
    expect(runs).toEqual(['a', 'a']);
  });

  it('runs at once again after a quiet window', () => {
    throttle.schedule('a');
    jest.advanceTimersByTime(2500);

    throttle.schedule('a');

    expect(runs).toEqual(['a', 'a']);
  });

  it('throttles each key on its own', () => {
    throttle.schedule('a');
    throttle.schedule('b');
    throttle.schedule('a');

    expect(runs).toEqual(['a', 'b']);
  });

  it('drops a pending trailing run when cancelled', () => {
    throttle.schedule('a');
    throttle.schedule('a');

    throttle.cancel('a');
    jest.advanceTimersByTime(5000);

    expect(runs).toEqual(['a']);
  });
});
