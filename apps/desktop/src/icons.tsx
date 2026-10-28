import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import * as paths from './iconPaths.tsx';

export type IconScale = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type IconProps = ComponentPropsWithoutRef<'svg'> & {
  weight?: 'regular' | 'bold';
  scale?: IconScale;
  size?: number | string;
};
type Glyph = { regular: ReactNode; bold?: ReactNode };

// Decorative glyphs: the containing control owns the accessible label. Only used weights ship.
function icon(glyph: Glyph, name: string) {
  const Component = forwardRef<SVGSVGElement, IconProps>(
    ({ className = '', weight = 'regular', scale, size, style, ...props }, ref) => {
      const active = weight === 'bold' && glyph.bold !== undefined;
      return (
        <svg
          {...props}
          ref={ref}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 256 256"
          fill="currentColor"
          className={`app-icon ${className}`.trim()}
          data-weight={active ? 'bold' : 'regular'}
          style={{
            ...(scale ? { width: `var(--icon-${scale})`, height: `var(--icon-${scale})` } : {}),
            ...(size !== undefined ? { width: size, height: size } : {}),
            ...style,
          }}
          aria-hidden="true"
          focusable="false"
        >
          {active ? glyph.bold : glyph.regular}
        </svg>
      );
    },
  );
  Component.displayName = name;
  return Component;
}

export const Activity = icon(paths.ActivityGlyph, 'Activity');
export const ArrowDown = icon(paths.ArrowDownGlyph, 'ArrowDown');
export const ArrowLeft = icon(paths.ArrowLeftGlyph, 'ArrowLeft');
export const ArrowRight = icon(paths.ArrowRightGlyph, 'ArrowRight');
export const ArrowUp = icon(paths.ArrowUpGlyph, 'ArrowUp');
export const ArrowUpToLine = icon(paths.ArrowUpToLineGlyph, 'ArrowUpToLine');
export const Bell = icon(paths.BellGlyph, 'Bell');
export const Bot = icon(paths.BotGlyph, 'Bot');
export const CalendarClock = icon(paths.CalendarClockGlyph, 'CalendarClock');
export const Check = icon(paths.CheckGlyph, 'Check');
export const ChevronDown = icon(paths.ChevronDownGlyph, 'ChevronDown');
export const ChevronLeft = icon(paths.ChevronLeftGlyph, 'ChevronLeft');
export const ChevronRight = icon(paths.ChevronRightGlyph, 'ChevronRight');
export const CircleHelp = icon(paths.CircleHelpGlyph, 'CircleHelp');
export const Copy = icon(paths.CopyGlyph, 'Copy');
export const Database = icon(paths.DatabaseGlyph, 'Database');
export const Download = icon(paths.DownloadGlyph, 'Download');
export const Ellipsis = icon(paths.EllipsisGlyph, 'Ellipsis');
export const ExternalLink = icon(paths.ExternalLinkGlyph, 'ExternalLink');
export const FileDown = icon(paths.FileDownGlyph, 'FileDown');
export const FileCode = icon(paths.FileCodeGlyph, 'FileCode');
export const FileText = icon(paths.FileTextGlyph, 'FileText');
export const FoldVertical = icon(paths.FoldVerticalGlyph, 'FoldVertical');
export const Folder = icon(paths.FolderGlyph, 'Folder');
export const FolderInput = icon(paths.FolderInputGlyph, 'FolderInput');
export const FolderOpen = icon(paths.FolderOpenGlyph, 'FolderOpen');
export const FolderSymlink = icon(paths.FolderSymlinkGlyph, 'FolderSymlink');
export const GitBranch = icon(paths.GitBranchGlyph, 'GitBranch');
export const GitFork = icon(paths.GitForkGlyph, 'GitFork');
export const Globe = icon(paths.GlobeGlyph, 'Globe');
export const Hand = icon(paths.HandGlyph, 'Hand');
export const Eye = icon(paths.EyeGlyph, 'Eye');
export const Image = icon(paths.ImageGlyph, 'Image');
export const Info = icon(paths.InfoGlyph, 'Info');
export const Keyboard = icon(paths.KeyboardGlyph, 'Keyboard');
export const Laptop = icon(paths.LaptopGlyph, 'Laptop');
export const ListChecks = icon(paths.ListChecksGlyph, 'ListChecks');
export const ListOrdered = icon(paths.ListOrderedGlyph, 'ListOrdered');
export const LoaderCircle = icon(paths.LoaderCircleGlyph, 'LoaderCircle');
export const LogOut = icon(paths.LogOutGlyph, 'LogOut');
export const MessageSquare = icon(paths.MessageSquareGlyph, 'MessageSquare');
export const MessagesSquare = icon(paths.MessagesSquareGlyph, 'MessagesSquare');
export const PanelLeft = icon(paths.PanelLeftGlyph, 'PanelLeft');
export const Pencil = icon(paths.PencilGlyph, 'Pencil');
export const Pin = icon(paths.PinGlyph, 'Pin');
export const PinOff = icon(paths.PinOffGlyph, 'PinOff');
export const Play = icon(paths.PlayGlyph, 'Play');
export const Plus = icon(paths.PlusGlyph, 'Plus');
export const RefreshCw = icon(paths.RefreshCwGlyph, 'RefreshCw');
export const RotateCcw = icon(paths.RotateCcwGlyph, 'RotateCcw');
export const ScrollText = icon(paths.ScrollTextGlyph, 'ScrollText');
export const Search = icon(paths.SearchGlyph, 'Search');
export const Settings = icon(paths.SettingsGlyph, 'Settings');
export const Settings2 = icon(paths.Settings2Glyph, 'Settings2');
export const ShieldAlert = icon(paths.ShieldAlertGlyph, 'ShieldAlert');
export const ShieldCheck = icon(paths.ShieldCheckGlyph, 'ShieldCheck');
export const ShieldOff = icon(paths.ShieldOffGlyph, 'ShieldOff');
export const Shrink = icon(paths.ShrinkGlyph, 'Shrink');
export const SlidersHorizontal = icon(paths.SlidersHorizontalGlyph, 'SlidersHorizontal');
export const Square = icon(paths.SquareGlyph, 'Square');
export const SquarePen = icon(paths.SquarePenGlyph, 'SquarePen');
export const SquareSlash = icon(paths.SquareSlashGlyph, 'SquareSlash');
export const SquareTerminal = icon(paths.SquareTerminalGlyph, 'SquareTerminal');
export const Trash2 = icon(paths.Trash2Glyph, 'Trash2');
export const Unplug = icon(paths.UnplugGlyph, 'Unplug');
export const UserRound = icon(paths.UserRoundGlyph, 'UserRound');
export const Wrench = icon(paths.WrenchGlyph, 'Wrench');
export const X = icon(paths.XGlyph, 'X');

// Claude Spark, Simple Icons (CC0). Source and trademark attribution: docs/plans/2026-10-24-icons-glyphs.md.
export const Spark = icon(
  {
    regular: (
      <g transform="scale(10.6666666667)">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </g>
    ),
  },
  'Spark',
);
