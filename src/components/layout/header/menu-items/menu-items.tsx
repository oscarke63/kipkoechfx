import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { MenuItem, Text } from '@deriv-com/ui';
import { useTranslations } from '@deriv-com/translations';
import { LabelPairedCircleInfoCaptionRegularIcon } from '@deriv/quill-icons/LabelPaired';

export const MenuItems = observer(() => {
    const { localize } = useTranslations();
    const store = useStore();
    const is_logged_in = store?.client?.is_logged_in ?? false;

    return (
        <>
            {is_logged_in && (
                <MenuItem
                    as='a'
                    className='app-header__menu'
                    href='/#free_bots'
                    leftComponent={LabelPairedCircleInfoCaptionRegularIcon}
                >
                    <Text>{localize('Free Bots')}</Text>
                </MenuItem>
            )}
        </>
    );
});

export const TradershubLink = observer(() => {
    return null;
});

type MenuItemsType = typeof MenuItems & {
    TradershubLink: typeof TradershubLink;
};

(MenuItems as MenuItemsType).TradershubLink = TradershubLink;

export default MenuItems as MenuItemsType;
