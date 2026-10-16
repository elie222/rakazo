import { Input as InputPrimitive } from "@base-ui/react/input";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { cn } from "@rakazo/ui-web/lib/utils";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";

const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

/** The labels of the show/hide button on hidden fields; the kit itself is not translated. */
const RevealLabelsContext = React.createContext({ show: "Show password", hide: "Hide password" });

/** Supplies translated labels for the show/hide button of every hidden field below it. */
function InputRevealLabelsProvider({
  show,
  hide,
  children,
}: {
  show: string;
  hide: string;
  children: React.ReactNode;
}) {
  const labels = React.useMemo(() => ({ show, hide }), [show, hide]);
  return <RevealLabelsContext.Provider value={labels}>{children}</RevealLabelsContext.Provider>;
}

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  if (type === "password") return <HiddenInput className={className} {...props} />;
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputClass, className)}
      {...props}
    />
  );
}

/**
 * A field whose value is hidden, with a button that shows it. The caller's classes go on the
 * input like any other field. The input is a block, so its margins pass through the wrapper and
 * the button stays centred on the field.
 */
function HiddenInput({
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const labels = React.useContext(RevealLabelsContext);
  const [shown, setShown] = React.useState(false);
  // Disabling the field, say while a form submits, hides the value again, and it stays hidden
  // when the field is enabled again.
  if (disabled && shown) setShown(false);
  const visible = shown && !disabled;
  return (
    <div data-slot="input-reveal" className="relative w-full min-w-0">
      <InputPrimitive
        type={visible ? "text" : "password"}
        data-slot="input"
        disabled={disabled}
        className={cn(inputClass, "block", className, "pr-9")}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={visible ? labels.hide : labels.show}
        // A click leaves the caret in the field; the keyboard still reaches the button.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setShown((current) => !current)}
        className="absolute inset-y-0 right-1 my-auto text-muted-foreground"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
}

export { Input, InputRevealLabelsProvider };
