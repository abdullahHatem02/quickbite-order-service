/**
 * Module-level types for the assignment module. Per CLAUDE.md §5, helper shapes
 * live here rather than inline in the service.
 */

/** The offer body broadcast to candidate agents over WebSocket. */
export interface OfferPayload {
    orderId: string; // public_id
    branch: {id: number; lat: number; lng: number; name: string; addressText: string};
    dropoff: {lat: number; lng: number; addressText: string};
    total: number;
    currency: string;
    paymentMethod: string;
    expiresAt: string;
}
