// 标准拨动开关：轨道 + 滑块，开 = 强调色实心，关 = 中性灰轨道。
// 设置里所有"启用/停用"都走这一个组件，避免圆钮、方片、播放三角几种语义混用。
export default function PillSwitch({ checked, onChange, disabled, size = "md", title }) {
  const sm = size === "sm";
  const track = sm ? "h-5 w-9" : "h-6 w-11";
  const knob = sm ? "h-3.5 w-3.5" : "h-[18px] w-[18px]";
  const shift = sm ? "translate-x-4" : "translate-x-5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      disabled={disabled}
      title={title}
      onClick={() => !disabled && onChange?.(!checked)}
      className={`relative ${track} shrink-0 rounded-full border transition-colors duration-200 ${
        checked
          ? "accent-solid border-transparent"
          : "border-neutral-300 bg-neutral-200 dark:border-neutral-700 dark:bg-neutral-800"
      } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"} ${
        !disabled ? "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" : ""
      }`}
    >
      <span
        className={`pointer-events-none absolute top-1/2 left-0.5 ${knob} -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? shift : "translate-x-0"
        }`}
      />
    </button>
  );
}
