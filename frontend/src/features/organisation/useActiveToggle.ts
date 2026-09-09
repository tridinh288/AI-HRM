import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api';

/**
 * Deactivate and reactivate, for either reference table.
 *
 * Deactivation is refused by the server while anyone still belongs to the row,
 * and the refusal names the count — so the caller surfaces that message rather
 * than a generic failure. Reactivation is a plain `isActive` update, which is
 * why neither is a delete: the history stays true either way.
 *
 * Lives apart from the forms because a file that exports both a hook and a
 * component loses Fast Refresh.
 */
export function useActiveToggle(kind: 'departments' | 'positions') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; activate: boolean }) => {
      if (input.activate) {
        await api.patch(`/${kind}/${input.id}`, { isActive: true });
      } else {
        await api.post(`/${kind}/${input.id}/deactivate`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [kind] });
    },
  });
}
