import React from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

/**
 * Theme-aware toggle switch.
 * Implemented as a native checkbox (appearance: none) with role="switch",
 * so label-wrapping, keyboard (Space) and form semantics all work natively.
 * Styles live in styles/index.css (.switch / .switch-sm), driven by theme vars.
 */
export const Switch: React.FC<SwitchProps> = ({ checked, onChange, disabled, size = 'md', ariaLabel }) => (
  <input
    type="checkbox"
    role="switch"
    className={size === 'sm' ? 'switch switch-sm' : 'switch'}
    checked={checked}
    disabled={disabled}
    aria-label={ariaLabel}
    onChange={e => onChange(e.target.checked)}
  />
);
