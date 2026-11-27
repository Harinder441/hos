import { Mark } from './signals.js';

export function Wordmark() {
  return (
    <span className="wordmark">
      <strong>hos</strong>
      <span className="wordmark-marks" aria-hidden="true">
        <Mark signal="go" />
        <Mark signal="needs" />
        <Mark signal="yield" />
        <Mark signal="stop" />
      </span>
    </span>
  );
}
