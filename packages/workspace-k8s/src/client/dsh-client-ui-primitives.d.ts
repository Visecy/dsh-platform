/**
 * The slice of `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` this plugin
 * uses, declared locally.
 *
 * The package is IN the composition but is not an installed dependency of this
 * one — the web shell ships it as a static seed word of the browser module
 * table (`dsh-web-frontend/dist/assets/index-*.js` maps the specifier next to
 * `react` and `dsh-client-ui-slots`) and every official client bundle requires
 * it at runtime. Adding it to `package.json` is not possible here (that would
 * move the frozen lockfile), so the import resolves at runtime through the
 * module table and is declared here for type-aware tools.
 *
 * DELETE this file if the package ever becomes a real dependency: the shipped
 * `lib/index.d.ts` is the source of truth (and is what the declarations below
 * were read from), and a local declaration would then shadow it.
 *
 * `data-*` attributes are part of the contract — the Modal's documented
 * initial-focus hook is `data-modal-autofocus` on the field, not React's
 * `autoFocus`.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

  /** Attributes every primitives member may carry through to its element. */
  interface DataAttributes {
    [key: `data-${string}`]: unknown
  }

  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    /** Required unless `headless`; the accessible label of the close control. */
    closeLabel: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    backdropBlur?: boolean
  } & DataAttributes): ReactNode

  export const Button: (props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement> & DataAttributes) => ReactNode

  export const Input: (props: {
    icon?: ReactNode
    /** Extra class on the wrapper span, NOT on the native input. */
    className?: string
  } & InputHTMLAttributes<HTMLInputElement> & DataAttributes) => ReactNode

  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactNode
}
