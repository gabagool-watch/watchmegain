import { cn, formatCurrency, formatPnL, formatNumber } from '@/lib/utils';

interface StatsCardProps {
  title: string;
  value: number;
  format?: 'currency' | 'pnl' | 'number' | 'percent';
  subtitle?: string;
  trend?: number;
  className?: string;
}

export function StatsCard({
  title,
  value,
  format = 'currency',
  subtitle,
  trend,
  className,
}: StatsCardProps) {
  let displayValue: string;
  let valueColor = 'text-surface-100';

  switch (format) {
    case 'pnl': {
      const pnl = formatPnL(value);
      displayValue = pnl.text;
      valueColor = pnl.color;
      break;
    }
    case 'currency':
      displayValue = formatCurrency(value);
      break;
    case 'number':
      displayValue = formatNumber(value, 0);
      break;
    case 'percent':
      displayValue = `${formatNumber(value * 100, 1)}%`;
      break;
  }

  return (
    <div className={cn('card', className)}>
      <p className="text-sm text-surface-400 mb-1">{title}</p>
      <p className={cn('text-2xl font-semibold', valueColor)}>{displayValue}</p>
      {subtitle && (
        <p className="text-xs text-surface-500 mt-1">{subtitle}</p>
      )}
      {trend !== undefined && (
        <p className={cn(
          'text-xs mt-1',
          trend >= 0 ? 'text-green-400' : 'text-red-400'
        )}>
          {trend >= 0 ? '↑' : '↓'} {formatNumber(Math.abs(trend) * 100, 1)}% vs last period
        </p>
      )}
    </div>
  );
}
