import { CircleDollarSign, Link2, Mail, RefreshCw, Wallet } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import { Button, Card, colors, ErrorNotice, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

type Provider = "square" | "xero" | "revolut" | "google";
type Connection = {
  provider: Provider;
  configured: boolean;
  status: "unconfigured" | "credential_saved" | "needs_selection" | "verified" | "error";
  identity?: string;
  verifiedAt?: string;
  verificationFresh: boolean;
  lastSyncAt?: string;
  tenants?: { id: string; name: string }[];
};

const providers = [
  { id: "square", name: "Square", icon: CircleDollarSign },
  { id: "xero", name: "Xero", icon: Link2 },
  { id: "revolut", name: "Revolut Business", icon: Wallet },
  { id: "google", name: "Gmail", icon: Mail },
] as const;

function connectionLabel(item?: Connection) {
  if (!item) return "Checking…";
  if (item.status === "verified") return item.identity ? `Verified · ${item.identity}` : "Verified";
  if (item.status === "needs_selection") return "Choose an organisation";
  if (item.status === "credential_saved") return "Connected · verification needed";
  if (item.status === "error") return "Needs attention";
  return item.configured ? "Ready to connect" : "Set up on Oracle";
}

export function BusinessConnections({ query = "" }: { query?: string }) {
  const { api, notify } = useWorkspace();
  const [items, setItems] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<Provider>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.request<Connection[]>("/api/business/connections"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const connect = (provider: Provider) =>
    action(async () => {
      const result = await api.request<{ url?: string | null }>(
        `/api/business/connections/${provider}/connect`,
        {},
      );
      if (result.url) {
        await Linking.openURL(result.url);
        notify("Finish connecting in your browser, then refresh this connection.");
      }
    });
  const verify = (provider: Provider) =>
    action(async () => {
      await api.request(`/api/business/connections/${provider}/verify`, {});
      notify("Account identity checked with the provider.");
    });
  const chooseTenant = (tenantId: string) =>
    action(async () => {
      await api.request("/api/business/connections/xero/tenant", { tenantId });
    });
  const visible = providers.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  const chosen = selected && items.find((item) => item.provider === selected);
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.heading}>Business data</Text>
      <Text style={s.muted}>Live account status and verified identity, kept on Oracle.</Text>
      <Card style={{ paddingVertical: 2 }}>
        {visible.map((provider) => (
          <LinkRow
            key={provider.id}
            icon={provider.icon}
            title={provider.name}
            detail={connectionLabel(items.find((item) => item.provider === provider.id))}
            onPress={() => {
              setError("");
              setSelected(provider.id);
            }}
          />
        ))}
        {loading && <ActivityIndicator color={colors.blueDark} />}
      </Card>
      {selected && (
        <Sheet
          title={providers.find((p) => p.id === selected)?.name || "Business connection"}
          subtitle={connectionLabel(chosen)}
          onClose={() => setSelected(undefined)}
        >
          <View style={{ gap: 16 }}>
            <ErrorNotice error={error} />
            {chosen?.identity && <Text style={s.text}>Account: {chosen.identity}</Text>}
            {chosen?.verifiedAt && (
              <Text style={s.small}>
                Identity checked: {new Date(chosen.verifiedAt).toLocaleString()}
              </Text>
            )}
            {chosen?.lastSyncAt && (
              <Text style={s.small}>Last sync: {new Date(chosen.lastSyncAt).toLocaleString()}</Text>
            )}
            {chosen?.status === "verified" && !chosen.verificationFresh && (
              <Text style={s.muted}>The last identity check is older than 15 minutes.</Text>
            )}
            {chosen?.status === "needs_selection" &&
              chosen.tenants?.map((tenant) => (
                <Button key={tenant.id} busy={busy} onPress={() => void chooseTenant(tenant.id)}>
                  Use {tenant.name}
                </Button>
              ))}
            {chosen?.configured ? (
              <Button primary busy={busy} onPress={() => void connect(selected)}>
                Connect account
              </Button>
            ) : (
              <Text style={s.muted}>
                Add this provider’s app credentials on Oracle before connecting.
              </Text>
            )}
            {chosen && chosen.status !== "unconfigured" && (
              <Button busy={busy} onPress={() => void verify(selected)}>
                Verify account identity
              </Button>
            )}
            <Button small icon={RefreshCw} busy={loading} onPress={() => void refresh()}>
              Refresh status
            </Button>
          </View>
        </Sheet>
      )}
    </View>
  );
}
