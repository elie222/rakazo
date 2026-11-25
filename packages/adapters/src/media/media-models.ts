/** A media model a connection can choose, as its provider lists it. */
export interface MediaModelOption {
  id: string;
  label: string;
}

/** The models a connection offers for one kind of media, and the one it uses when none is chosen. */
export interface MediaModelList {
  defaultModel: MediaModelOption;
  models(): Promise<MediaModelOption[]>;
}

export type MediaKind = "images" | "video";
