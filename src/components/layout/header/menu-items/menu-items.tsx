import { useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { MenuItem, Text } from '@deriv-com/ui';
import { useTranslations } from '@deriv-com/translations';
import { LabelPairedCircleInfoCaptionRegularIcon } from '@deriv/quill-icons/LabelPaired';

export const MenuItems = observer(() => {
    const { localize } = useTranslations();
    const store = useStore();
    const is_logged_in = store?.client?.is_logged_in ?? false;

    const handleFreeBots = useCallback(() => {
        window.location.hash = '#free_bots';
    }, []);

    return (
        <>
            {is_logged_in && (
                <MenuItem
                    as='button'
                    className='app-header__menu'
                    onClick={handleFreeBots}
                    leftComponent={<LabelPairedCircleInfoCaptionRegularIcon height='24px' width='24px' />}
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
