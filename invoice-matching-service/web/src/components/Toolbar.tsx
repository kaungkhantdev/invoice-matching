import { useState } from "react";
import { IconButton } from "./Icon";

interface Props {
  search: string;
  onSearchChange: (search: string) => void;
  recheckBusy: boolean;
  onRecheck: () => void;
  /** Opens the dialog for an invoice with its PO screenshots: the only way to add an invoice. */
  onMatchWithPo: () => void;
}

/** Search, re-check all, and add an invoice with its PO. */
export function Toolbar({ search, onSearchChange, recheckBusy, onRecheck, onMatchWithPo }: Props) {
  const [searchOpen, setSearchOpen] = useState(false);

  /** Closing the search also clears it, so the whole list shows again. */
  const toggleSearch = () => {
    if (searchOpen) onSearchChange("");
    setSearchOpen(!searchOpen);
  };

  return (
    <div className="tools">
      {searchOpen && (
        <div className="search">
          <input
            type="search"
            placeholder="Supplier, invoice, PO…"
            aria-label="Search invoices"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            autoFocus
          />
        </div>
      )}
      <IconButton icon="search" label="Search" onClick={toggleSearch} />
      <IconButton
        icon="recheck"
        label="Re-check all"
        title="Re-check all (reload the suppliers from data/ and run every check again, no AI)"
        disabled={recheckBusy}
        onClick={onRecheck}
      />
      <IconButton
        icon="link"
        label="Match an invoice with its PO"
        title="Match an invoice with its PO (screenshots of the PO page)"
        primary
        onClick={onMatchWithPo}
      />
    </div>
  );
}
