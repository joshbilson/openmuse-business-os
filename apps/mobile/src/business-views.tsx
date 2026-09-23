import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { BusinessView, BusinessViewRow } from "../../../packages/domain/src/business-view";
import { formatBusinessMoney } from "./business-view-format";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function SourceRow({ row, layout }: { row: BusinessViewRow; layout: BusinessView["layout"] }) {
  const [expanded, setExpanded] = useState(false);
  const amount = formatBusinessMoney(row.money);
  return (
    <View
      style={{
        gap: 5,
        padding: layout === "cards" ? 14 : 10,
        borderRadius: layout === "cards" ? 14 : 0,
        backgroundColor: layout === "cards" ? colors.canvas : colors.card,
        borderBottomWidth: layout === "table" ? 1 : 0,
        borderBottomColor: colors.line,
      }}
    >
      <View style={[s.between, { gap: 12, alignItems: "flex-start" }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.label}>
            {row.provider.toUpperCase()} · {row.kind}
          </Text>
          <Text style={[s.text, { fontWeight: "600" }]}>{row.title}</Text>
        </View>
        {amount && <Text style={[s.text, { fontWeight: "600" }]}>{amount}</Text>}
      </View>
      {row.status && <Text style={s.small}>Status: {row.status}</Text>}
      <Text style={s.small}>Observed {dateLabel(row.observedAt)}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Source evidence for ${row.title}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={[s.row, { gap: 5, alignSelf: "flex-start", paddingVertical: 5 }]}
      >
        <Text style={[s.small, { color: colors.blueDark }]}>Source evidence</Text>
        {expanded ? (
          <ChevronUp size={13} color={colors.blueDark} />
        ) : (
          <ChevronDown size={13} color={colors.blueDark} />
        )}
      </Pressable>
      {expanded && (
        <View style={{ gap: 3, paddingTop: 3 }}>
          <Text selectable style={s.small}>
            Account: {row.identity}
          </Text>
          <Text selectable style={s.small}>
            Source ID: {row.sourceId}
          </Text>
          {row.evidence.sourceId !== row.sourceId && (
            <Text selectable style={s.small}>
              Evidence source ID: {row.evidence.sourceId}
            </Text>
          )}
          <Text selectable style={s.small}>
            Endpoint: {row.evidence.endpoint}
          </Text>
          {row.evidence.tenantId && (
            <Text selectable style={s.small}>
              Tenant: {row.evidence.tenantId}
            </Text>
          )}
          <Text style={s.small}>Fetched: {dateLabel(row.evidence.fetchedAt)}</Text>
          {row.occurredAt && <Text style={s.small}>Occurred: {dateLabel(row.occurredAt)}</Text>}
          {row.evidence.sourceTimestamp && (
            <Text selectable style={s.small}>
              Source timestamp: {row.evidence.sourceTimestamp}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

export function BusinessViews({ query = "" }: { query?: string }) {
  const { api } = useWorkspace();
  const [views, setViews] = useState<BusinessView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setViews(await api.request<BusinessView[]>("/api/business/views"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const needle = query.trim().toLowerCase();
  const matching = views.filter(
    (view) =>
      !needle ||
      view.title.toLowerCase().includes(needle) ||
      view.rows.some((row) =>
        `${row.title} ${row.provider} ${row.kind}`.toLowerCase().includes(needle),
      ),
  );
  const visible = showAll ? matching : matching.slice(0, 4);
  return (
    <View style={{ gap: 10 }}>
      <View style={[s.between, { gap: 12 }]}>
        <Text style={s.heading}>Business views</Text>
        <Button small icon={RefreshCw} busy={loading} onPress={() => void refresh()}>
          Refresh
        </Button>
      </View>
      <Text style={s.muted}>
        Saved snapshots from verified sources. Amounts and balances may have changed since observed.
      </Text>
      <ErrorNotice error={error} />
      {loading && !views.length && <ActivityIndicator color={colors.blueDark} />}
      {!loading && !error && !views.length && (
        <Card>
          <Text style={s.text}>No saved business views yet.</Text>
          <Text style={s.muted}>Ask OpenMuse to build a view from connected business data.</Text>
        </Card>
      )}
      {visible.map((view) => {
        const rows = expanded[view.id] ? view.rows : view.rows.slice(0, 5);
        return (
          <Card key={view.id} style={{ gap: 12 }}>
            <View style={[s.between, { gap: 10, alignItems: "flex-start" }]}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.heading}>{view.title}</Text>
                <Text style={s.small}>Snapshot · Created {dateLabel(view.createdAt)}</Text>
              </View>
              <Text style={s.label}>{view.layout === "table" ? "TABLE" : "CARDS"}</Text>
            </View>
            <View style={{ gap: view.layout === "cards" ? 8 : 0 }}>
              {rows.map((row) => (
                <SourceRow key={row.id} row={row} layout={view.layout} />
              ))}
            </View>
            {view.rows.length > 5 && (
              <Button
                small
                onPress={() =>
                  setExpanded((current) => ({ ...current, [view.id]: !current[view.id] }))
                }
              >
                {expanded[view.id] ? "Show fewer rows" : `Show all ${view.rows.length} rows`}
              </Button>
            )}
          </Card>
        );
      })}
      {matching.length > 4 && (
        <Button small onPress={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer views" : `Show all ${matching.length} views`}
        </Button>
      )}
    </View>
  );
}
