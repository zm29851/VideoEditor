import { Checkbox as RadixCheckbox, Dialog as RadixDialog, Progress, Select as RadixSelect, Slider as RadixSlider, Tabs as RadixTabs, Toast, Tooltip } from "radix-ui";
import { Check, ChevronDown, Minus, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./ui.module.css";

/** Data-driven positions reach CSS only through variables, as DESIGN.md requires. */
export function useCssVars<T extends HTMLElement>(vars: Record<string, string | number>): RefObject<T | null> {
  const ref = useRef<T>(null);
  const key = JSON.stringify(vars);
  useLayoutEffect(() => {
    for (const [name, value] of Object.entries(vars)) ref.current?.style.setProperty(name, String(value));
  }, [key]);
  return ref;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" };

export function Button({ variant = "secondary", className, ...props }: ButtonProps) {
  return <button type="button" className={`${styles.button} ${styles[variant]} ${className ?? ""}`} {...props} />;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  pressed?: boolean;
};

/** An icon alone says too little, so it always carries a name and a tooltip. */
export function IconButton({ label, shortcut, pressed, className, ...props }: IconButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          className={`${styles.iconButton} ${className ?? ""}`}
          {...props}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltip} sideOffset={8}>
          {label}
          {shortcut && <kbd className={styles.kbd}>{shortcut}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The whole control is the click target, so its children name it and a long row stays one tab stop. */
export function Checkbox({
  checked,
  onClick,
  className,
  children,
}: {
  checked: boolean | "indeterminate";
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RadixCheckbox.Root checked={checked} onClick={onClick} className={`${styles.checkbox} ${className ?? ""}`}>
      <span className={styles.checkboxBox}>
        <RadixCheckbox.Indicator className={styles.checkboxMark}>
          {checked === "indeterminate" ? <Minus size={14} aria-hidden /> : <Check size={14} aria-hidden />}
        </RadixCheckbox.Indicator>
      </span>
      {children}
    </RadixCheckbox.Root>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  wide,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={`${styles.dialog} ${wide ? styles.dialogWide : ""}`}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className={styles.dialogHeader}>
            <RadixDialog.Title className={styles.dialogTitle}>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <button type="button" className={styles.iconButton} aria-label="Đóng">
                <X size={18} aria-hidden />
              </button>
            </RadixDialog.Close>
          </div>
          {description && <RadixDialog.Description className={styles.muted}>{description}</RadixDialog.Description>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface ToastMessage {
  id: number;
  text: string;
}

const ToastContext = createContext<(text: string) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function UiProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);
  const show = useCallback((text: string) => {
    setMessages((current) => [...current.filter((message) => message.text !== text), { id: nextId.current++, text }]);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      <Tooltip.Provider delayDuration={400}>
        <Toast.Provider duration={7000} label="Thông báo">
          {children}
          {messages.map((message) => (
            <Toast.Root
              key={message.id}
              className={styles.toast}
              onOpenChange={(open) => {
                if (!open) setMessages((current) => current.filter((item) => item.id !== message.id));
              }}
            >
              <Toast.Description>{message.text}</Toast.Description>
              <Toast.Close asChild>
                <button type="button" className={styles.iconButton} aria-label="Đóng thông báo">
                  <X size={16} aria-hidden />
                </button>
              </Toast.Close>
            </Toast.Root>
          ))}
          <Toast.Viewport className={styles.toastViewport} />
        </Toast.Provider>
      </Tooltip.Provider>
    </ToastContext.Provider>
  );
}

export function Tabs({ label, tabs, defaultValue }: { label: string; defaultValue: string; tabs: Array<{ value: string; title: string; content: ReactNode }> }) {
  return (
    <RadixTabs.Root className={styles.tabs} defaultValue={defaultValue}>
      <RadixTabs.List className={styles.tabList} aria-label={label}>
        {tabs.map((tab) => (
          <RadixTabs.Trigger key={tab.value} value={tab.value} className={styles.tab}>
            {tab.title}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.value} value={tab.value} className={styles.tabContent}>
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={onChange}>
      <RadixSelect.Trigger className={styles.selectTrigger} aria-label={label}>
        <RadixSelect.Value />
        <RadixSelect.Icon>
          <ChevronDown size={16} aria-hidden />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className={styles.selectContent} position="popper" sideOffset={4}>
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item key={option.value} value={option.value} className={styles.selectItem}>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator>
                  <Check size={16} aria-hidden />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export function ProgressBar({ value, label }: { value: number | undefined; label: string }) {
  const indicator = useCssVars<HTMLDivElement>({ "--progress": value ?? 0 });
  return (
    <Progress.Root className={styles.progress} value={value ?? null} aria-label={label}>
      <Progress.Indicator ref={indicator} className={styles.progressIndicator} />
    </Progress.Root>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}) {
  return (
    <RadixSlider.Root
      className={styles.slider}
      value={[value]}
      min={min}
      max={max}
      step={step ?? 1}
      onValueChange={([next]) => onChange(next!)}
      onValueCommit={([next]) => onCommit?.(next!)}
    >
      <RadixSlider.Track className={styles.sliderTrack}>
        <RadixSlider.Range className={styles.sliderRange} />
      </RadixSlider.Track>
      <RadixSlider.Thumb className={styles.sliderThumb} aria-label={label} />
    </RadixSlider.Root>
  );
}

/** Be Vietnam Pro has no tabular figures, so each digit gets a cell of its own to keep numbers from jumping. */
export function Digits({ value }: { value: string }) {
  return (
    <>
      {[...value].map((char, index) => (
        <span key={index} className={/\d/.test(char) ? styles.digit : undefined}>
          {char}
        </span>
      ))}
    </>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.emptyState}>
      <p className={styles.emptyTitle}>{title}</p>
      {children}
    </div>
  );
}
