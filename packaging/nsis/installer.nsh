; BIT — electron-builder 自定义 NSIS 钩子（由 electron-builder.yml 的 nsis.include 引入）
;
; 只拦一件事：把 ARM64 安装包下到 x64 电脑上。
;
; 为什么必须自己拦：ARM64 安装器的壳是 32 位 x86（BIT_<v>_aarch64-setup.exe 的 PE
; machine 头是 0x14c），在 x64 Windows 上能正常启动并把文件全部释放，安装"成功"；
; 但装进去的 BIT.exe 是 ARM64 二进制，而 x64 Windows 没有 ARM64 兼容层（只有反向：
; ARM64 Windows 可以模拟 x64）。用户看到的是卸载面板里躺着个装好的程序、桌面快捷方式
; 双击没反应，只能卸载重装。
;
; electron-builder 自带的 check64BitAndSetRegView（templates/nsis/common.nsh）只覆盖
; x64→32 位 Windows 这一种错配（MessageBox + Quit）；APP_ARM64 分支只调 SetRegView，
; 不拦 x64 主机装 ARM64。所以这一段补在 customInit 里——它在 .onInit 内、
; 且只在安装器（非 BUILD_UNINSTALLER）分支展开，解压前提前 Quit，不会留下半个安装。

!macro customInit
  !ifdef APP_ARM64
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_OK|MB_ICONSTOP "BIT ARM64 版装不了这台电脑。$\r$\n$\r$\n这台电脑的 CPU 不是 ARM64 架构。x64 版 Windows 运行不了 ARM64 程序，现在强行装完，图标双击也是没反应。$\r$\n$\r$\n请改下载文件名以 _x64-setup.exe 结尾的版本：$\r$\nhttps://yxpil.github.io/BrainTentacle/$\r$\n$\r$\n----------------------------------------$\r$\nThis is the ARM64 build and this PC is not ARM64. Windows on x64 cannot run ARM64 binaries, so the installed app would not launch. Please download the _x64-setup.exe build instead:$\r$\nhttps://yxpil.github.io/BrainTentacle/"
      Quit
    ${EndIf}
  !endif
!macroend
